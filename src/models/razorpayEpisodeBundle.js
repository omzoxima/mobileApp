import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const RazorpayEpisodeBundle = sequelize.define('RazorpayEpisodeBundle', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    plan_id: {
      type: DataTypes.STRING(128),
      allowNull: true
    },
    name: {
      type: DataTypes.STRING(128),
      allowNull: true
    },
    price: {
      // Store in smallest currency unit (e.g., paise) as integer to avoid FP errors
      type: DataTypes.BIGINT,
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('monthly', 'episode'),
      allowNull: true
    },
    points: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'razorpay_episode_bundles',
    timestamps: false,
    indexes: [
      { fields: ['plan_id'] },
      { fields: ['plan_id_ios'] },
      { fields: ['type'] },
      { fields: ['price'] }
    ]
  });

  return RazorpayEpisodeBundle;
};


